#!/usr/bin/env node
/* eslint-env node */
/**
 * 存量重复 pending 收敛（2026-11-21 收尾条 2）。
 *
 * 背景：hedged/推断候选的「跨会话并条」是 2026-11-19 才修好的写入语义，
 * 只对新写入生效。旧库里同一候选可能已经按会话各存一条（「可能：」前缀
 * 破坏过相似度匹配），这些副本不会被后续写入顺手收掉。本脚本按与写入
 * 路径同一套匹配规则（userId + type + provenance + pendingReason + 剥前缀
 * 相似度 ≥ PENDING_CANDIDATE_MATCH_MIN）把它们并回一条。
 *
 * 语义边界：
 *   - 只动 pending 且 pendingReason ∈ {user_hedged_requires_confirmation,
 *     low_confidence_candidate, model_inference_requires_confirmation}；
 *   - 合并后仍留在 pending —— 重复证据不撬开晋升（既有证据策略）；
 *   - 贡献按 (sessionId, sourceQuote) 去重，重复条目退场，keeper 留
 *     consolidatedFrom 审计链；记忆正文不进日志。
 *
 * 用法：
 *   node scripts/consolidate-pending-duplicates.js            # dry-run，只列分组
 *   node scripts/consolidate-pending-duplicates.js --apply    # 先备份再合并
 *   node scripts/consolidate-pending-duplicates.js --apply --userId=local-owner
 * 数据目录沿用 BLUEBIRD_DATA_DIR（与 server/memory.js 同一解析）。
 */
const fs = require('fs');
const path = require('path');

function pendingConsolidatePaths() {
  const dataDir = process.env.BLUEBIRD_DATA_DIR
    ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
    : path.join(__dirname, '..', 'server', 'data');

  return { DATA_DIR: dataDir, MEMORY_FILE: path.join(dataDir, 'memory.json') };
}

function argValue(flag) {
  const prefix = `${flag}=`;
  const hit = process.argv.find(item => item.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bak-${stamp}`;

  fs.copyFileSync(file, target);

  return target;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const userId = argValue('--userId');
  const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));

  memory.loadMemories();

  const before = memory.getMemories({ includePending: true, includeSuperseded: true, includeArchived: true }).length;
  const result = await memory.consolidatePendingDuplicates({
    apply,
    userId: userId || undefined,
  });

  console.log(
    `[consolidate] ${apply ? 'apply' : 'dry-run'} · 库内 ${before} 条 · ` +
      `发现 ${result.groups.length} 组重复 pending`
  );

  for (const group of result.groups) {
    console.log(
      `  keeper=${group.keeperId} reason=${group.pendingReason} ` +
        `并入=${group.duplicateIds.join(',')} 会话=${group.sessions.join('/') || '-'} ` +
        `正文=${String(group.content || '').slice(0, 40)}`
    );
  }

  if (!apply) {
    console.log(
      '[consolidate] dry-run 未写盘；确认分组无误后加 --apply（会先备份 memory.json）'
    );

    return result;
  }

  if (result.reason === 'write_failed') {
    console.error('[consolidate] 落盘失败，库未改动');
    process.exitCode = 1;

    return result;
  }

  console.log(
    `[consolidate] 已合并 ${result.mergedEntries} 条重复 pending，` +
      `退场 ${result.removedEntries} 条，库内剩 ${result.remaining} 条`
  );

  return result;
}

if (require.main === module) {
  // --apply 的备份必须在真正写盘之前完成，因此放在 require 记忆库之前。
  if (process.argv.includes('--apply')) {
    const saved = backup(pendingConsolidatePaths().MEMORY_FILE);

    if (saved) console.log(`[consolidate] 备份 → ${saved}`);
  }

  main().catch(error => {
    console.error(`[consolidate] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, backup, pendingConsolidatePaths };
