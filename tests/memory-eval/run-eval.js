#!/usr/bin/env node
/* eslint-env node */
/**
 * 云岫 Bluebird — 记忆系统评测基线（阶段 0 建立，P0–P3 改造后继续作为验收尺子）
 *
 * 运行：node tests/memory-eval/run-eval.js [--json]
 *      npm run eval:memory（同一入口）
 *      tests/memory-eval-baseline.test.js 把关键指标做成 CI 闸门
 *
 * 它做且只做四件事：
 *   1. 把固定种子记忆写进临时 BLUEBIRD_DATA_DIR 的 memory.json，再用生产代码
 *      server/memory.js 的 loadMemories() 读进来（不自己实现任何算分逻辑）；
 *   2. 对 26 道固定题分别调用三条真实读路径 ——
 *        scoped       路径：searchMemories({query, sessionId, limits})（Agent 工具 / Context Engine 用的）
 *        inject       路径：buildMemoryContext(query)（不带 sessionId 的兼容入口，应只回无归属旧数据）
 *        injectScoped 路径：buildMemoryContext(query, sessionId)（/chat 线上真正走的那条）
 *   3. 算 Recall@K / Precision@K / 跨会话泄漏数 / 更正残留 / 删除残留 / 检索延迟；
 *   4. 事实更正与删除类题目走真实写路径（processMemory + 假 client、
 *      recallMemoryBySourceQuote、deleteMemory、clearMemories、clearSessionMemories），跑完再检索。
 *
 * 指标「不达标」不会让本脚本非零退出：只有脚本自身异常才 exit 1，
 * 门槛判定交给 tests/memory-eval-baseline.test.js。
 *
 * 隔离：临时目录用后即焚，绝不读写 server/data 的真实记忆文件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-eval-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const MEMORY_FILE = path.join(TMP, 'memory.json');

// 生产模块自身会 console.log 大量流水（Memory loaded / Memory saved / AI call），
// 评测输出必须干净：全部吞掉，只用 origLog 打印报表。
const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};

const memory = require(path.join(__dirname, '..', '..', 'server', 'memory.js'));
const engine = require(path.join(__dirname, '..', '..', 'server', 'context', 'engine.js'));
const fixtures = require('./fixtures');

// 与 server/tool-memory-search.js:15-22 的 LIMITS 逐项一致：
// 工具层把 limitMax=10 作为 maxItems 传进 searchMemories。
const LIMITS = Object.freeze({ maxItems: 10, perItemMax: 300, totalMax: 2000 });
const K_LIST = [5, 10];
const DEFAULT_TOOL_LIMIT = 5; // tool-memory-search.js:20 limitDefault

let reg = fixtures.registry();
const unmapped = new Set();

function idOf(content) {
  const id = reg.get(content);

  if (!id) unmapped.add(content);

  return id || null;
}

function seedStore(items) {
  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(items || fixtures.seed(), null, 2),
    'utf8'
  );
  memory.loadMemories();
}

function diskItems() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (error) {
    return { error: error.message };
  }
}

function liveContents() {
  return memory.getMemories().map(item => item.content);
}

function containsContent(items, content) {
  return Array.isArray(items) && items.some(item => item.content === content);
}

/** scoped 路径：真实 searchMemories，顺带计时。 */
function scopedRetrieve(query, session) {
  const t0 = process.hrtime.bigint();
  const found = memory.searchMemories({
    query,
    sessionId: session,
    limits: LIMITS,
  });
  const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;

  return {
    ids: found.results.map(item => idOf(item.content)).filter(Boolean),
    reason: found.reason || null,
    truncated: found.truncated === true,
    total: found.total,
    dtMs,
  };
}

/** inject 路径：真实 buildMemoryContext，从渲染文本里还原条目顺序。
 *  sessionId 传入 = 线上真实路径（/chat 会带）；不传 = 兼容入口，应退化为「只注入无归属旧数据」。
 *  两条都要跑：前者证明加了隔离后召回还健康，后者证明不带 sessionId 也不再泄漏别人的会话。 */
function injectedRetrieve(query, sessionId = null) {
  const t0 = process.hrtime.bigint();
  const text = memory.buildMemoryContext(query, sessionId);
  const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const contents = text
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim());

  return {
    ids: contents.map(idOf).filter(Boolean),
    count: contents.length,
    sessionId: sessionId || null,
    dtMs,
  };
}

function scorePath(ids, question, k, forbid) {
  const top = ids.slice(0, k);
  const expected = question.expect || [];
  const hits = top.filter(id => expected.includes(id)).length;

  return {
    hits,
    recall: expected.length ? hits / expected.length : null,
    precision: hits / k,
    leaks: (forbid || question.forbid || []).filter(id => top.includes(id)),
    top,
  };
}

/**
 * 生效的禁止清单 = 题目显式 forbid ∪ 「只属于其他会话」的全部种子。
 * 后者对每个提问会话都成立：只要一条记忆的所有贡献都不在这个会话名下，
 * 它就不该出现在这个会话的 scoped 结果里，也不该被无 sessionId 的全局注入读到
 * （server/memory.js:849-872 有这层隔离，server/memory.js:617 完全没有）。
 */
function effectiveForbid(session) {
  const privates = fixtures.SEEDS.filter(
    item =>
      item.contributions.length &&
      item.contributions.every(
        contribution => contribution.sessionId && contribution.sessionId !== session
      )
  ).map(item => item.id);

  return Array.from(new Set(privates));
}

function percentile(values, p) {
  if (!values.length) return null;

  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);

  return sorted[Math.max(0, index)];
}

function stats(values) {
  if (!values.length) return null;

  const sum = values.reduce((a, b) => a + b, 0);

  return {
    n: values.length,
    mean: +(sum / values.length).toFixed(3),
    p50: +percentile(values, 0.5).toFixed(3),
    p95: +percentile(values, 0.95).toFixed(3),
    max: +Math.max(...values).toFixed(3),
  };
}

function mean(values) {
  const clean = values.filter(value => value !== null && value !== undefined);

  return clean.length
    ? +(clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(4)
    : null;
}

function fmtIds(ids) {
  if (!ids.length) return '∅';

  const shown = ids.slice(0, 6).join(',');

  return `${shown}${ids.length > 6 ? `…(共${ids.length})` : ''}`;
}

// 假 client：只负责把固定 JSON 交回给真实的 extractMemory 校验/去重逻辑。
function fakeClient(reply) {
  // 字符串 reply 表示「模型回了话但没回 JSON」——探针要靠它测 model_empty 这条路。
  const content =
    typeof reply === 'string' ? reply : JSON.stringify(reply);

  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
        }),
      },
    },
  };
}

const report = {
  meta: {
    node: process.version,
    dataDir: TMP,
    storeSize: fixtures.SEEDS.length,
    smallMemoryLimit: 15,
    questions: fixtures.QUESTIONS.length,
    toolLimits: LIMITS,
    note: '指标不达标不代表脚本失败；unmapped 必须为空，否则说明检索回来的正文不在题库里',
  },
  phase1: { perQuestion: [], metrics: {} },
  phase2: { perQuestion: [] },
  phase3: { perQuestion: [] },
  phase4: {},
};

// ---------------------------------------------------------------- Phase 1
function runPhase1() {
  seedStore();

  const latencies = { scoped: [], inject: [], injectScoped: [] };
  const per = {
    recall: {
      scoped: { 5: [], 10: [] },
      inject: { 5: [], 10: [] },
      injectScoped: { 5: [], 10: [] },
    },
    precision: {
      scoped: { 5: [], 10: [] },
      inject: { 5: [], 10: [] },
      injectScoped: { 5: [], 10: [] },
    },
  };
  const byCategory = {};
  let scopedLeaks = 0;
  let injectLeaks = 0;
  let injectScopedLeaks = 0;
  let legacyExposure = 0;
  let crossPathDisagreement = 0;
  let noAnswerFalsePositives = 0;
  let noAnswerTotal = 0;

  for (const question of fixtures.QUESTIONS.filter(item => item.phase === 1)) {
    const scoped = scopedRetrieve(question.query, question.session);
    // 不带 sessionId 的兼容入口（审计里泄漏 20 次的那条）
    const inject = injectedRetrieve(question.query);
    // 带 sessionId 的线上入口（/chat 实际走的就是这条）
    const injectScoped = injectedRetrieve(question.query, question.session);

    latencies.scoped.push(scoped.dtMs);
    latencies.inject.push(inject.dtMs);
    latencies.injectScoped.push(injectScoped.dtMs);

    const forbid = Array.from(
      new Set([...(question.forbid || []), ...effectiveForbid(question.session)])
    );

    const row = {
      id: question.id,
      cat: question.cat,
      session: question.session,
      query: question.query,
      expect: question.expect,
      forbid,
      scoped: {},
      inject: {},
      injectScoped: {},
    };

    for (const k of K_LIST) {
      const s = scorePath(scoped.ids, question, k, forbid);
      const j = scorePath(inject.ids, question, k, forbid);
      const js = scorePath(injectScoped.ids, question, k, forbid);

      row.scoped[k] = s;
      row.inject[k] = j;
      row.injectScoped[k] = js;

      per.recall.scoped[k].push(s.recall);
      per.recall.inject[k].push(j.recall);
      per.recall.injectScoped[k].push(js.recall);
      per.precision.scoped[k].push(s.precision);
      per.precision.inject[k].push(j.precision);
      per.precision.injectScoped[k].push(js.precision);

      scopedLeaks += s.leaks.length;
      injectLeaks += j.leaks.length;
      injectScopedLeaks += js.leaks.length;
    }

    // 同一事实在两条路径可见性不一致：scoped 拿不到、inject 拿得到
    if (question.cross) {
      const visibleToInject = row.inject[10].top.includes(question.cross);
      const visibleToScoped = row.scoped[10].top.includes(question.cross);

      row.crossSession = {
        id: question.cross,
        scopedVisible: visibleToScoped,
        injectVisible: visibleToInject,
        injectScopedVisible: row.injectScoped[10].top.includes(question.cross),
      };

      if (visibleToInject && !visibleToScoped) crossPathDisagreement += 1;
    }

    // legacy 无归属暴露：新会话按设计能读到别的新会话写不进去的旧数据
    if (question.session === fixtures.SESSIONS.fresh) {
      legacyExposure += row.scoped[10].top.includes('M12') ? 1 : 0;
    }

    if (question.cat === '无答案') {
      noAnswerTotal += 1;

      const falseHits = row.scoped[DEFAULT_TOOL_LIMIT].top.length;

      if (falseHits > 0) noAnswerFalsePositives += 1;

      row.noAnswer = {
        scopedReturnedAtDefaultLimit: falseHits,
        injectReturned: inject.count,
        injectScopedReturned: injectScoped.count,
      };
    }

    const bucket = (byCategory[question.cat] ||= {
      recall5Scoped: [],
      recall10Scoped: [],
      recall5Inject: [],
      recall10Inject: [],
      recall5InjectScoped: [],
      recall10InjectScoped: [],
      leaksScoped: 0,
      leaksInject: 0,
      leaksInjectScoped: 0,
      n: 0,
    });

    bucket.recall5Scoped.push(row.scoped[5].recall);
    bucket.recall10Scoped.push(row.scoped[10].recall);
    bucket.recall5Inject.push(row.inject[5].recall);
    bucket.recall10Inject.push(row.inject[10].recall);
    bucket.recall5InjectScoped.push(row.injectScoped[5].recall);
    bucket.recall10InjectScoped.push(row.injectScoped[10].recall);
    bucket.leaksScoped += row.scoped[10].leaks.length;
    bucket.leaksInject += row.inject[10].leaks.length;
    bucket.leaksInjectScoped += row.injectScoped[10].leaks.length;
    bucket.n += 1;

    report.phase1.perQuestion.push(row);

    origLog(
      `${question.id} ${question.cat.padEnd(5, ' ')} [${question.session}] "${question.query}"`
    );
    origLog(
      `  scoped R@5=${row.scoped[5].recall ?? '-'} R@10=${row.scoped[10].recall ??
        '-'} P@10=${row.scoped[10].precision} 泄漏=${row.scoped[10].leaks.length} ` +
        `n=${row.scoped[10].top.length} ${scoped.dtMs.toFixed(3)}ms  ${fmtIds(row.scoped[10].top)}`
    );
    origLog(
      `  inject 召回=${row.inject[10].recall ?? '-'} 泄漏=${row.inject[10].leaks.length} ` +
        `n=${inject.count} ${inject.dtMs.toFixed(3)}ms  ${fmtIds(inject.ids)}`
    );
    origLog(
      `  injectScoped 召回=${row.injectScoped[10].recall ??
        '-'} 泄漏=${row.injectScoped[10].leaks.length} ` +
        `n=${injectScoped.count} ${injectScoped.dtMs.toFixed(3)}ms  ${fmtIds(injectScoped.ids)}`
    );
  }

  const metrics = {
    recallAtK: {
      scoped: {
        5: mean(per.recall.scoped[5]),
        10: mean(per.recall.scoped[10]),
      },
      inject: {
        5: mean(per.recall.inject[5]),
        10: mean(per.recall.inject[10]),
      },
      injectScoped: {
        5: mean(per.recall.injectScoped[5]),
        10: mean(per.recall.injectScoped[10]),
      },
    },
    precisionAtK: {
      scoped: {
        5: mean(per.precision.scoped[5]),
        10: mean(per.precision.scoped[10]),
      },
      inject: {
        5: mean(per.precision.inject[5]),
        10: mean(per.precision.inject[10]),
      },
      injectScoped: {
        5: mean(per.precision.injectScoped[5]),
        10: mean(per.precision.injectScoped[10]),
      },
    },
    crossSessionLeaks: {
      scoped: scopedLeaks,
      inject: injectLeaks,
      injectScoped: injectScopedLeaks,
      definition: 'forbid 列（仅属其他会话的记忆）出现在返回结果里的次数总和；injectScoped = 带 sessionId 的线上注入路径',
    },
    crossPathDisagreement,
    legacyUnattributedExposure: legacyExposure,
    noAnswerQuestions: {
      total: noAnswerTotal,
      withFalseRetrievals: noAnswerFalsePositives,
      definition: `expect 为空的题，在工具默认 limit=${DEFAULT_TOOL_LIMIT} 下仍返回条目的题数`,
    },
    byCategory,
    latencyMs: {
      scoped: stats(latencies.scoped),
      inject: stats(latencies.inject),
      injectScoped: stats(latencies.injectScoped),
      unit: '毫秒，进程内直接调用真实函数，不含 HTTP/模型开销',
    },
  };

  report.phase1.metrics = metrics;

  return metrics;
}

// ---------------------------------------------------------------- Phase 2
async function runPhase2() {
  origLog('');
  origLog('== Phase 2 事实更正（真实写路径：processMemory + 假 client）==');

  // 候选正文先登记，检索结果才能映射回 id
  for (const write of fixtures.PHASE2_WRITES) {
    if (write.newId) reg.set(write.reply.content, write.newId);
  }

  for (const question of fixtures.QUESTIONS.filter(item => item.phase === 2)) {
    const write = fixtures.PHASE2_WRITES.find(
      item => item.key === question.writeKey
    );

    seedStore();

    const before = memory.getMemories().length;

    // 写路径的真实结论：不再用「库容有没有 +1」推断是否写入 ——
    // 更正走 supersede（旧条目转 superseded、新条目 +1、总数可能不变），
    // 合并走就地更新（总数不变），只有纯新增才会让总数变大。
    const outcome = await memory.processMemory(
      fakeClient(write.reply),
      question.userText || write.userText,
      question.session
    );

    const after = memory.getMemories().length;
    const afterContents = liveContents();
    const scoped = scopedRetrieve(question.query, question.session);
    const inject = injectedRetrieve(question.query);
    const injectScoped = injectedRetrieve(question.query, question.session);

    const oldContent = fixtures.SEEDS.find(
      item => item.id === question.residueOf
    )?.content;
    const oldStillInStore = oldContent
      ? afterContents.includes(oldContent)
      : false;
    const oldStillRetrievable = question.residueOf
      ? scoped.ids.includes(question.residueOf)
      : false;

    // 磁盘层：被更正的旧条目以 status=superseded 留在文件里做审计，
    // 这是设计意图，不算残留 —— 残留只看「还能不能被读到」。
    const rawDisk = diskItems();
    const oldOnDiskAsSuperseded =
      oldContent && Array.isArray(rawDisk)
        ? rawDisk.some(
            item => item.content === oldContent && item.status === 'superseded'
          )
        : false;

    const row = {
      id: question.id,
      query: question.query,
      userText: write.userText,
      // 以 processMemory 的真实结论为准：written + action（merged/superseded/inserted）
      wroteNewEntry: outcome ? outcome.written === true : after > before,
      writeAction: outcome ? outcome.action : null,
      writeReason: outcome ? outcome.reason || null : null,
      newEntryId: outcome ? outcome.id || null : null,
      supersededId: outcome ? outcome.supersededId || null : null,
      storeSize: { before, after },
      newId: write.newId,
      residueOf: question.residueOf || null,
      newEntryRank: write.newId ? scoped.ids.indexOf(write.newId) + 1 || null : null,
      oldEntryRank: question.residueOf
        ? scoped.ids.indexOf(question.residueOf) + 1 || null
        : null,
      replacedId: question.replaces || write.replaces,
      oldStillInStore,
      oldStillRetrievableByScoped: oldStillRetrievable,
      oldOnDiskAsSuperseded,
      oldAlsoVisibleToInject: question.residueOf
        ? inject.ids.includes(question.residueOf)
        : false,
      oldAlsoVisibleToInjectScoped: question.residueOf
        ? injectScoped.ids.includes(question.residueOf)
        : false,
      scopedTop: scoped.ids,
      injectTop: inject.ids,
      injectScopedTop: injectScoped.ids,
      expect: question.expect,
      forbid: question.forbid,
      recallScopedAt10: scorePath(
        scoped.ids,
        question,
        10,
        Array.from(
          new Set([...(question.forbid || []), ...effectiveForbid(question.session)])
        )
      ).recall,
      recallInjectScopedAt10: scorePath(
        injectScoped.ids,
        question,
        10,
        Array.from(
          new Set([...(question.forbid || []), ...effectiveForbid(question.session)])
        )
      ).recall,
      leaksScoped: scorePath(
        scoped.ids,
        question,
        10,
        effectiveForbid(question.session)
      ).leaks,
      leaksInject: scorePath(
        inject.ids,
        question,
        10,
        effectiveForbid(question.session)
      ).leaks,
      leaksInjectScoped: scorePath(
        injectScoped.ids,
        question,
        10,
        effectiveForbid(question.session)
      ).leaks,
    };

    report.phase2.perQuestion.push(row);

    origLog(
      `${question.id} "${write.userText}" → 候选正文「${write.reply.content}」`
    );
    origLog(
      `  写入=${row.wroteNewEntry ? '是' : '否'} 动作=${row.writeAction} ` +
      `拒写短码=${row.writeReason ?? '-'} 新id=${row.newEntryId ?? '-'} ` +
      `被更正id=${row.supersededId ?? '-'} 库容 ${before}→${after} ` +
        `新条目在 scoped 结果中的位次=${row.newEntryRank ?? '-'}`
    );
    origLog(
      `  旧条目(${question.residueOf || '-'}) 仍在活跃库=${oldStillInStore} ` +
        `仍被 scoped 检索命中=${oldStillRetrievable} ` +
        `仍被全局注入=${row.oldAlsoVisibleToInject} ` +
        `仍被会话内注入=${row.oldAlsoVisibleToInjectScoped} ` +
        `磁盘留档为 superseded=${oldOnDiskAsSuperseded} ` +
        `新旧位次=scoped 第${row.oldEntryRank ?? '-'} 位 vs 第${row.newEntryRank ?? '-'} 位`
    );
    origLog(
      `  scoped ${fmtIds(scoped.ids)} / inject ${fmtIds(inject.ids)} / ` +
        `injectScoped ${fmtIds(injectScoped.ids)}`
    );
  }

  // 拒写原因鉴别：只改 content 与 sourceQuote 的相似度，其余全同。
  // 这一组同时验证「拒写原因可观测化」：每条被拒的候选都要回传稳定短码，
  // 调用方才能区分「模型没提取 / 被锚点拒 / 被置信度拒」。
  const gateRows = [];

  for (const probe of fixtures.GATE_PROBES) {
    // 被拒的候选会把「待记忆意图」留给下一条消息（server/memory.js:849-852）。
    // 这是真实行为，但会让下一条不带的触发词的消息也被提取，
    // not_triggered 探针就测不到它想测的那道闸门 —— 先跑一次成功的写入把意图消费掉。
    if (probe.consumePendingIntent) {
      // 正文与原话逐字相同，保证这次清洗写入一定过锚点闸门；
      // 清洗失败反而会把意图又置回 true，探针就永远测不到 not_triggered。
      await memory.processMemory(
        fakeClient({
          content: '记住：这是一次用于清空待记忆意图的写入',
          type: 'fact',
          keywords: ['清洗'],
          confidence: 0.99,
          sourceQuote: '记住：这是一次用于清空待记忆意图的写入',
        }),
        '记住：这是一次用于清空待记忆意图的写入',
        fixtures.SESSIONS.main
      );
    }

    seedStore();

    const before = memory.getMemories().length;

    const outcome = await memory.processMemory(
      fakeClient(probe.reply),
      probe.userText,
      fixtures.SESSIONS.main
    );

    const after = memory.getMemories().length;
    const wrote = outcome
      ? outcome.written === true
      : after > before;

    if (probe.reply && typeof probe.reply === 'object') {
      reg.set(probe.reply.content, 'GATE');
    }

    const scoped = scopedRetrieve(
      '我的猫叫什么名字',
      fixtures.SESSIONS.main
    );

    const reason = outcome ? outcome.reason || null : null;

    gateRows.push({
      key: probe.key,
      content: probe.reply.content,
      wrote,
      action: outcome ? outcome.action : null,
      reason,
      expectWritten: probe.expectWritten,
      expectReason: probe.expectReason,
      // 判据错位即为 false，进 metrics.gateProbeMismatches
      matches:
        wrote === probe.expectWritten && reason === probe.expectReason,
      anchorScore: outcome ? (outcome.detail || {}).anchorScore ?? null : null,
      keywordHits: outcome ? (outcome.detail || {}).keywordHits ?? null : null,
      storeSize: { before, after },
      scopedTop: scoped.ids,
    });

    origLog(
      `鉴别探针 ${probe.key}：期望写入=${probe.expectWritten ? '是' : '否'} ` +
        `期望短码=${probe.expectReason ?? '-'} → 实际写入=${wrote ? '是' : '否'} ` +
        `动作=${gateRows[gateRows.length - 1].action} 短码=${reason ?? '-'} ` +
        `锚点分=${gateRows[gateRows.length - 1].anchorScore ?? '-'} ` +
        `关键词命中=${gateRows[gateRows.length - 1].keywordHits ?? '-'} ` +
        `判据${gateRows[gateRows.length - 1].matches ? '符合' : '不符'} ` +
        `库容 ${before}→${after}`
    );
  }

  report.phase2.gateProbes = gateRows;

  const corrections = report.phase2.perQuestion.filter(
    item => item.residueOf
  );

  // 拒写都要带短码：把 phase2 全部「没写成」的题/探针合起来数一次。
  // 逐题行的短码字段叫 writeReason、探针行叫 reason，这里先归一再看，
  // 否则字段名不同会被当成「没带短码」，报出一个根本不存在的可观测性缺口。
  const rejectedAll = [
    ...report.phase2.perQuestion
      .filter(item => item.wroteNewEntry === false)
      .map(item => ({ key: item.id, reason: item.writeReason })),
    ...gateRows
      .filter(item => item.wrote === false)
      .map(item => ({ key: item.key, reason: item.reason })),
  ];

  report.phase2.metrics = {
    correctionResidueCount: corrections.filter(
      item => item.oldStillInStore || item.oldStillRetrievableByScoped
    ).length,
    correctionHandledBySupersede: corrections.filter(
      item => item.writeAction === 'superseded' && item.oldOnDiskAsSuperseded
    ).length,
    definition:
      '更正残留 = 更正后旧事实仍在活跃记忆集里（getMemories 默认视图）或仍可被检索命中的题数；' +
      '旧条目转 status=superseded 留在磁盘做审计，不计入残留',
    rejectedAttempts: rejectedAll.length,
    rejectedWithReason: rejectedAll.filter(item => item.reason).length,
    rejectedWithoutReason: rejectedAll.filter(item => !item.reason).length,
    rejectedWithoutReasonKeys: rejectedAll
      .filter(item => !item.reason)
      .map(item => item.key),
    // 每个探针只动一道闸门，判据不符说明闸门行为变了（不再能区分拒写成因）
    gateProbeMismatches: gateRows
      .filter(item => item.matches === false)
      .map(item => `${item.key}: 期望 ${item.expectReason ?? '-'} / 实际 ${item.reason ?? '-'}`),
    gateProbeReasons: gateRows.map(item => `${item.key}=${item.reason ?? '-'}`),
  };

  origLog(
    `更正残留数 = ${report.phase2.metrics.correctionResidueCount}` +
      `（其中走 supersede 留档 ${report.phase2.metrics.correctionHandledBySupersede}）`
  );
  origLog(
    `拒写有短码 ${report.phase2.metrics.rejectedWithReason} / 无短码 ${report.phase2.metrics.rejectedWithoutReason}`
  );
  origLog(
    `拒写成因鉴别：${report.phase2.metrics.gateProbeReasons.join(' ')}` +
      `，判据不符 ${report.phase2.metrics.gateProbeMismatches.length} 个`
  );
}

// ---------------------------------------------------------------- Phase 3
async function runPhase3() {
  origLog('');
  origLog('== Phase 3 删除/撤回后残留 ==');

  seedStore();

  const residueRows = [];

  for (const probe of fixtures.SAFETY_PROBES) {
    const messageTime = fixtures.at(probe.messageAtMinutes);
    const dropped = await memory.recallMemoryBySourceQuote(
      probe.messageText,
      messageTime,
      probe.session
    );

    const contents = liveContents();
    const surviveOk = (probe.mustSurvive || []).every(
      id => contents.includes(fixturesContent(id))
    );
    const dropOk = (probe.mustDrop || []).every(
      id => !contents.includes(fixturesContent(id))
    );

    const row = {
      id: probe.id,
      kind: 'safety',
      session: probe.session,
      messageText: probe.messageText,
      // 撤回现在回两个计数：整条删除数 + 摘掉的贡献数
      entriesDeletedReturned: dropped.removedEntries,
      contributionsDropped: dropped.removedContributions,
      expectedEntriesDeleted: probe.expectDropped,
      otherSessionSurvived: surviveOk,
      targetDropped: dropOk,
      storeSize: memory.getMemories().length,
      diskConsistent: memory.verifyStoreConsistency().consistent === true,
    };

    residueRows.push(row);

    origLog(
      `${probe.id} 会话=${probe.session} 撤回「${probe.messageText}」@${messageTime}` +
        ` → 整条删除 ${dropped.removedEntries}（期望 ${probe.expectDropped}）` +
        ` 摘掉贡献 ${dropped.removedContributions}` +
        ` 库容=${row.storeSize} 应存活满足=${surviveOk} 应删除满足=${dropOk} ` +
        `内存/磁盘一致=${row.diskConsistent}`
    );
  }

  for (const question of fixtures.QUESTIONS.filter(item => item.phase === 3)) {
    let opResult;

    if (question.op === 'deleteMemory') {
      const content = fixturesContent(question.target);
      const entry = memory
        .getMemories()
        .find(item => item.content === content);

      // 定位方式优先用稳定 id（新路径），id 缺失才退回 createdAt + content（旧路径）
      const removed = entry && entry.id
        ? await memory.deleteMemory({ id: entry.id })
        : await memory.deleteMemory({
            createdAt: entry ? entry.createdAt : '',
            content,
          });

      opResult = {
        api: 'deleteMemory',
        locator: entry && entry.id ? 'id' : 'createdAt+content',
        ...removed,
      };
    } else if (question.op === 'clearMemories') {
      const cleared = await memory.clearMemories();
      opResult = { api: 'clearMemories', ...cleared };
    } else if (question.op === 'clearSessionMemories') {
      const cleared = await memory.clearSessionMemories(question.session);
      opResult = { api: 'clearSessionMemories', session: question.session, ...cleared };
    } else {
      const dropped = await memory.recallMemoryBySourceQuote(
        question.messageText,
        fixtures.at(question.messageAtMinutes),
        question.session
      );

      opResult = {
        api: 'recallMemoryBySourceQuote',
        entriesDeletedReturned: dropped.removedEntries,
        contributionsDropped: dropped.removedContributions,
      };
    }

    const probes = (question.queries || [question.query]).map(query => {
      const scoped = scopedRetrieve(query, question.session);
      const inject = injectedRetrieve(query);
      const injectScoped = injectedRetrieve(query, question.session);

      return { query, scoped, inject, injectScoped };
    });

    const target = question.target
      ? fixturesContent(question.target)
      : null;
    const inMemory = target
      ? liveContents().includes(target)
      : memory.getMemories().length > 0;
    const disk = diskItems();
    const onDisk = Array.isArray(disk)
      ? target
        ? disk.some(item => item.content === target)
        : disk.length > 0
      : true;
    const stillScoped = target
      ? probes.some(item => item.scoped.ids.includes(question.target))
      : probes.some(item => item.scoped.ids.length > 0);
    const stillInjected = target
      ? probes.some(item => item.inject.ids.includes(question.target))
      : probes.some(item => item.inject.count > 0);
    const stillInjectedScoped = target
      ? probes.some(item => item.injectScoped.ids.includes(question.target))
      : probes.some(item => item.injectScoped.count > 0);

    const residueSurfaces = {
      stillInMemoryArray: inMemory,
      stillOnDisk: onDisk,
      stillRetrievableByScoped: stillScoped,
      stillRetrievableByInject: stillInjected,
      stillRetrievableByInjectScoped: stillInjectedScoped,
    };
    const residueCount = Object.values(residueSurfaces).filter(
      Boolean
    ).length;

    const row = {
      id: question.id,
      kind: question.op,
      target: question.target,
      mustSurvive: question.mustSurvive === true,
      opResult,
      // 摘掉部分贡献、条目还在时 removedEntries=0 但 removedContributions>0：
      // 两个计数分开回传，调用方能区分「没匹配上」和「摘掉一条贡献」。
      contributionsAfter: target
        ? (Array.isArray(disk)
            ? disk.find(item => item.content === target)
            : null)?.contributions ?? null
        : null,
      probes: probes.map(item => ({
        query: item.query,
        scoped: item.scoped.ids,
        inject: item.inject.ids,
        injectScoped: item.injectScoped.ids,
        expect: question.expect,
      })),
      residueSurfaces,
      residueCount,
      memoryDiskConsistent:
        inMemory === onDisk &&
        memory.verifyStoreConsistency().consistent === true,
    };

    residueRows.push(row);

    origLog(
      `${question.id} ${question.op} target=${question.target || 'ALL'} → ` +
        JSON.stringify(opResult)
    );
    for (const item of row.probes) {
      origLog(
        `    "${item.query}" scoped=${fmtIds(item.scoped)} inject=${fmtIds(
          item.inject
        )} injectScoped=${fmtIds(item.injectScoped)}`
      );
    }
    origLog(
      `    残留面=${JSON.stringify(residueSurfaces)} 残留数=${residueCount} ` +
        `内存/磁盘一致=${row.memoryDiskConsistent} ` +
        `贡献列表剩余=${JSON.stringify(row.contributionsAfter)}`
    );
  }

  // 按会话清理（P1-3）：清掉一个会话，别的会话的记忆必须一条不少。
  // 上面 Q26 已把整库清空，这里重新播种再单独跑清理，避免互相污染。
  seedStore();

  const cleanupSession = fixtures.SESSIONS.work;
  const sizeBefore = memory.getMemories().length;

  const ownerOf = id => {
    const seeded = fixtures.SEEDS.find(entry => entry.id === id);

    return (
      seeded &&
      (seeded.contributions || []).some(c => c.sessionId === cleanupSession)
    );
  };

  const ownedIds = fixtures.SEEDS.filter(item => ownerOf(item.id)).map(
    item => item.id
  );

  const cleared = await memory.clearSessionMemories(cleanupSession);

  const contentsAfter = liveContents();
  const diskAfterCleanup = diskItems();

  // 清理的判据是「贡献」而不是「条目」：本会话的贡献必须全部消失，
  // 但同一事实若还有别的会话说过，条目本身要留着（不是残留）。
  const contributionsStillOwnedByTarget = Array.isArray(diskAfterCleanup)
    ? diskAfterCleanup
        .filter(item =>
          (item.contributions || []).some(
            c => c.sessionId === cleanupSession
          )
        )
        .map(item => item.content)
    : ['<磁盘不可读>'];

  const foreignGone = fixtures.SEEDS.filter(
    item =>
      !ownerOf(item.id) &&
      !contentsAfter.includes(item.content)
  ).map(item => item.id);
  const scopedAfter = scopedRetrieve('我平时用什么编辑器', cleanupSession);
  const scopedOther = scopedRetrieve('我喜欢喝什么咖啡', fixtures.SESSIONS.main);

  const cleanupRow = {
    id: 'C1',
    kind: 'clearSessionMemories',
    session: cleanupSession,
    opResult: cleared,
    storeSize: { before: sizeBefore, after: memory.getMemories().length },
    ownedByTarget: ownedIds,
    contributionsStillOwnedByTarget,
    foreignMissing: foreignGone,
    targetScopedTop: scopedAfter.ids,
    otherSessionScopedTop: scopedOther.ids,
    diskConsistent: memory.verifyStoreConsistency().consistent === true,
  };

  residueRows.push(cleanupRow);

  origLog(
    `C1 clearSessionMemories 会话=${cleanupSession} → ${JSON.stringify(cleared)} ` +
      `库容 ${sizeBefore}→${cleanupRow.storeSize.after}`
  );
  origLog(
    `    本会话贡献未清空=${JSON.stringify(contributionsStillOwnedByTarget)} ` +
      `被误删的他会话条目=${JSON.stringify(foreignGone)} ` +
      `他会话检索仍可用=${scopedOther.ids.length > 0} ` +
      `内存/磁盘一致=${cleanupRow.diskConsistent}`
  );

  report.phase3.perQuestion = residueRows;

  const mutating = residueRows.filter(
    item =>
      !item.mustSurvive &&
      item.kind !== 'safety' &&
      typeof item.residueCount === 'number'
  );

  report.phase3.metrics = {
    deletionResidueCount: mutating.reduce((sum, item) => sum + item.residueCount, 0),
    deletionResidueDefinition:
      '应被删除的记忆仍存在于内存数组 / 磁盘 / scoped 检索 / 无归属注入 / 带会话注入 五个面上的次数总和',
    safetyProbeFailures: residueRows
      .filter(
        item =>
          item.kind === 'safety' &&
          (item.entriesDeletedReturned !== item.expectedEntriesDeleted ||
            item.otherSessionSurvived === false ||
            item.targetDropped === false ||
            item.diskConsistent === false)
      )
      .map(item => item.id),
    memoryDiskInconsistencies: residueRows
      .filter(item => item.memoryDiskConsistent === false)
      .map(item => item.id),
    // 摘掉了贡献却没有任何计数体现的题号（现在两个计数分开回传，应为空）
    recallSilentlyReturnedZero: residueRows
      .filter(item => {
        if (!item.target || !item.contributionsAfter) return false;

        const seeded = fixtures.SEEDS.find(entry => entry.id === item.target);

        return (
          seeded &&
          item.contributionsAfter.length < seeded.contributions.length &&
          item.opResult.entriesDeletedReturned === 0 &&
          !(item.opResult.contributionsDropped > 0)
        );
      })
      .map(item => item.id),
    sessionCleanup: {
      contributionsStillOwnedByTarget:
        cleanupRow.contributionsStillOwnedByTarget,
      foreignMissing: cleanupRow.foreignMissing,
      diskConsistent: cleanupRow.diskConsistent,
      otherSessionStillSearchable: scopedOther.ids.length > 0,
      definition:
        '按会话清理后：该会话的贡献应全部从库里消失（contributionsStillOwnedByTarget 应为空）、' +
        '其他会话独有的条目一条不少（foreignMissing 应为空）、磁盘与内存一致',
    },
  };

  origLog(
    `删除残留数 = ${report.phase3.metrics.deletionResidueCount}` +
      `；撤回误删防护探针失败=${JSON.stringify(
        report.phase3.metrics.safetyProbeFailures
      )}；内存/磁盘不一致=${JSON.stringify(
        report.phase3.metrics.memoryDiskInconsistencies
      )}；` +
      `摘掉贡献却返回 0 的题=${JSON.stringify(
        report.phase3.metrics.recallSilentlyReturnedZero
      )}`
  );
}

function fixturesContent(id) {
  const item = fixtures.SEEDS.find(entry => entry.id === id);

  return item ? item.content : null;
}

// ---------------------------------------------------------------- Phase 4
// Context Engine 开启后的对照：同一条查询，scoped 直连检索 vs 引擎裁决注入。
// 需要「同一事实的两条近似候选」才能触发裁决分支（server/context/engine.js:184
// 的分组阈值是相似度 ≥0.5），因此这里用一份专用小库，不用 22 条主库。
async function runPhase4() {
  origLog('');
  origLog('== Phase 4 Context Engine 对照（近似重复候选的裁决）==');

  const conflictStore = [
    {
      content: '用户喝咖啡只喝拿铁',
      type: 'preference',
      keywords: ['咖啡'],
      confidence: 0.95,
      contributions: [
        {
          sessionId: fixtures.SESSIONS.main,
          sourceQuote: '我喝咖啡只喝拿铁',
          createdAt: fixtures.at(-60),
        },
      ],
      createdAt: fixtures.at(-60),
      updatedAt: fixtures.at(-60),
    },
    {
      content: '用户喝咖啡只喝美式',
      type: 'preference',
      keywords: ['咖啡'],
      confidence: 0.95,
      contributions: [
        {
          sessionId: fixtures.SESSIONS.main,
          sourceQuote: '我喝咖啡只喝美式',
          createdAt: fixtures.at(-30),
        },
      ],
      createdAt: fixtures.at(-30),
      updatedAt: fixtures.at(-30),
    },
    {
      content: '用户不喝别的饮料',
      type: 'preference',
      keywords: ['饮料'],
      confidence: 0.9,
      contributions: [
        {
          sessionId: fixtures.SESSIONS.main,
          sourceQuote: '我不喝别的饮料',
          createdAt: fixtures.at(-20),
        },
      ],
      createdAt: fixtures.at(-20),
      updatedAt: fixtures.at(-20),
    },
  ];

  const contentToId = new Map([
    ['用户喝咖啡只喝拿铁', 'X1'],
    ['用户喝咖啡只喝美式', 'X2'],
    ['用户不喝别的饮料', 'X3'],
  ]);

  const previousRegistry = reg;
  reg = contentToId;

  seedStore(conflictStore);

  const query = '我喝咖啡选什么';
  const scoped = scopedRetrieve(query, fixtures.SESSIONS.main);
  const engineOut = await engine.runContextRuntime({
    task: query,
    sessionId: fixtures.SESSIONS.main,
    projectedMessages: [],
    renderMessage: () => null,
    systemBlocks: [
      { id: 'core', kind: 'core', priority: 100, critical: true, text: '你是云岫。' },
    ],
    currentMessage: { role: 'user', content: query },
  });

  const rendered = engineOut.systemPrompt || '';

  reg = previousRegistry;

  const skipped = engineOut.memory ? engineOut.memory.skipped : [];
  const skippedBy = reason => skipped.filter(item => item.reason === reason).length;

  report.phase4 = {
    query,
    storeSize: conflictStore.length,
    scopedDirect: { ids: scoped.ids, count: scoped.ids.length },
    engine: {
      ok: engineOut.ok,
      error: engineOut.error || null,
      route: 'direct',
      retrievedItems: [
        {
          source: 'memory',
          status: engineOut.trace.retrieval.status,
          count: engineOut.trace.retrieval.candidates,
        },
      ],
      selected: engineOut.memory ? engineOut.memory.accepted.length : 0,
      conflicts: engineOut.memory ? engineOut.memory.conflicts.length : 0,
      demoted: skippedBy('demoted_to_pending'),
      expired: skippedBy('expired_realtime_refetch'),
      injectedLines: rendered
        .split('\n')
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2).trim()),
      unknownFreshnessMarks: (rendered.match(/（时效未知）/g) || []).length,
    },
    verdict:
      '同组近似候选按来源/时间/覆盖关系裁决；未覆盖的补充事实保留，不整组丢弃',
  };

  origLog(
    `查询「${query}」 直连检索命中 ${scoped.ids.length} 条 = ${fmtIds(scoped.ids)}`
  );
  origLog(
    `引擎：ok=${engineOut.ok} route=${report.phase4.engine.route} ` +
      `selected=${report.phase4.engine.selected} conflicts=${report.phase4.engine.conflicts} ` +
      `注入行=${JSON.stringify(report.phase4.engine.injectedLines)} ` +
      `标记「时效未知」的行数=${report.phase4.engine.unknownFreshnessMarks}`
  );
  origLog(report.phase4.verdict);
}

// ---------------------------------------------------------------- driver
async function main() {
  origLog(
    `记忆评测基线 · 种子 ${fixtures.SEEDS.length} 条 · 题目 ${fixtures.QUESTIONS.length} 道 · ` +
      `临时库 ${TMP}`
  );
  origLog('');

  const phase1 = runPhase1();

  origLog('');
  origLog('== Phase 1 汇总 ==');
  origLog(
    `Recall@5  scoped=${phase1.recallAtK.scoped[5]} inject=${phase1.recallAtK.inject[5]}` +
      `   Recall@10 scoped=${phase1.recallAtK.scoped[10]} inject=${phase1.recallAtK.inject[10]}`
  );
  origLog(
    `Precision@5 scoped=${phase1.precisionAtK.scoped[5]} inject=${phase1.precisionAtK.inject[5]}` +
      `   Precision@10 scoped=${phase1.precisionAtK.scoped[10]} inject=${phase1.precisionAtK.inject[10]}`
  );
  origLog(
    `跨会话泄漏数 scoped=${phase1.crossSessionLeaks.scoped} inject=${phase1.crossSessionLeaks.inject}` +
      ` 路径结论不一致=${phase1.crossPathDisagreement} legacy暴露=${phase1.legacyUnattributedExposure}`
  );
  origLog(
    `无答案题 ${phase1.noAnswerQuestions.total} 道，其中误召回 ${phase1.noAnswerQuestions.withFalseRetrievals} 道`
  );
  origLog(
    `检索延迟(ms) scoped=${JSON.stringify(phase1.latencyMs.scoped)}`
  );
  origLog(
    `           inject=${JSON.stringify(phase1.latencyMs.inject)}`
  );

  await runPhase2();
  await runPhase3();
  await runPhase4();

  origLog('');
  origLog('== 基线指标汇总 ==');
  origLog(
    JSON.stringify(
      {
        phase1: report.phase1.metrics,
        phase2: report.phase2.metrics,
        phase3: report.phase3.metrics,
        phase4: report.phase4,
      },
      null,
      2
    )
  );

  if (process.argv.includes('--json')) {
    origLog('');
    origLog('== 完整逐题结果 JSON ==');
    origLog(JSON.stringify(report, null, 2));
  }

  // CI 闸门（tests/memory-eval-baseline.test.js）用文件消费完整报告：
  // 报表 stdout 里混着中文说明，从 stdout 里抠 JSON 会让判据依赖打印格式。
  const jsonOutArg = process.argv
    .find(arg => arg.startsWith('--json-out='))
    ?.slice('--json-out='.length);

  if (jsonOutArg) {
    fs.writeFileSync(
      path.resolve(jsonOutArg),
      JSON.stringify(
        {
          meta: report.meta,
          metrics: {
            phase1: report.phase1.metrics,
            phase2: report.phase2.metrics,
            phase3: report.phase3.metrics,
            phase4: report.phase4,
          },
          perQuestion: {
            phase1: report.phase1.perQuestion,
            phase2: report.phase2.perQuestion,
            phase3: report.phase3.perQuestion,
          },
          // 闸门判据不符时，CI 报告里要能直接看到每个探针的期望/实际，不用重跑
          gateProbes: report.phase2.gateProbes,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  if (unmapped.size) {
    origLog('');
    origLog(
      `警告：${unmapped.size} 条检索回来的正文不在题库映射里：` +
        JSON.stringify([...unmapped])
    );
  }

  origLog('');
  origLog('评测完成（指标失败不等于脚本失败）。');
}

main()
  .then(() => {
    console.log = origLog;
    console.error = origError;

    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (error) {
      origError(`临时目录清理失败（不影响结论）：${error.message}`);
    }

    process.exit(0);
  })
  .catch(error => {
    console.log = origLog;
    console.error = origError;

    origError('评测脚本异常：', error && error.stack ? error.stack : error);

    process.exit(1);
  });
