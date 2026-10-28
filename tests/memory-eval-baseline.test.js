/**
 * 云岫 Bluebird — 记忆评测基线 CI 闸门（P3）
 *
 * 把 tests/memory-eval/run-eval.js 的指标变成会真的让 npm test 失败的断言。
 * 评测脚本本身「指标不达标也 exit 0」，判据全部集中在这里，一处改一处生效。
 *
 * 三条硬性要求的验收数字就在这些断言里：
 *   - 「inject 泄漏 20 → 0」      → crossSessionLeaks 三条路径全 0
 *   - 「基线 Q20/Q21 变绿」       → 更正残留 0 且走 supersede 留档 ≥1
 *   - 「任何一条路径都不能串读」   → scoped / inject / injectScoped 三路同时为 0，
 *                                    外加跨会话删除/按会话清理的残留与一致性
 *
 * 判据分两类：
 *   1. 隐私与数据正确性 = 精确等式，任何非 0 都是回归，不给余量；
 *   2. 质量与性能 = 下界/上界，基线值写在断言消息里，放宽必须改这里。
 *
 * 隔离：评测脚本自己 mkdtemp 一个临时 BLUEBIRD_DATA_DIR，本文件只 spawn 子进程；
 *       绝不读写 server/data 的真实记忆文件。
 * 运行：node tests/memory-eval-baseline.test.js（也在 npm test 自动发现范围内）
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-mem-baseline-')),
  'report.json'
);

let report = null;
let evalStdout = '';

before(() => {
  const result = spawnSync(
    process.execPath,
    [
      path.join('tests', 'memory-eval', 'run-eval.js'),
      `--json-out=${REPORT_FILE}`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        // 空串而非删除：dotenv 只回填「不存在」的变量，空串才能挡住真实模型调用。
        DEEPSEEK_API_KEY: '',
      },
    }
  );

  assert.equal(
    result.status,
    0,
    `评测脚本自身异常退出（status=${result.status}）：\n${result.stderr || ''}`
  );

  evalStdout = result.stdout || '';

  assert.ok(
    fs.existsSync(REPORT_FILE),
    '评测脚本没有写出 --json-out 报告，CI 判据无从取数'
  );

  report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
});

const p1 = () => report.metrics.phase1;
const p2 = () => report.metrics.phase2;
const p3 = () => report.metrics.phase3;
const p4 = () => report.metrics.phase4;

describe('评测脚本自证', () => {
  test('跑完的题目数与种子数符合题库（防止题库被悄悄删题）', () => {
    assert.equal(report.meta.questions, 26, '固定题库应有 26 题');
    assert.equal(report.meta.storeSize, 22, '种子记忆应有 22 条');
    assert.equal(report.perQuestion.phase1.length, 19);
    assert.ok(report.perQuestion.phase2.length >= 2, '更正类题目不能为空');
    assert.ok(report.perQuestion.phase3.length >= 2, '删除类题目不能为空');
  });

  test('检索回来的正文全部落在题库映射里（unmapped 必须为空）', () => {
    assert.ok(
      !evalStdout.includes('不在题库映射里'),
      `有检索结果不在题库映射内，指标不可信：\n${evalStdout
        .split('\n')
        .filter(line => line.includes('不在题库映射里'))
        .join('\n')}`
    );
  });
});

describe('P0-2 会话隔离：三条读路径都不得串读', () => {
  test('跨会话泄漏数 scoped / inject / injectScoped 全为 0', () => {
    const leaks = p1().crossSessionLeaks;

    assert.equal(leaks.scoped, 0, 'scoped 检索路径串读了其他会话的记忆');
    assert.equal(leaks.inject, 0, '无 sessionId 的注入路径串读了具名会话的记忆');
    assert.equal(leaks.injectScoped, 0, '线上带 sessionId 的注入路径串读了其他会话的记忆');
  });

  test('同一个问题在 scoped 与注入路径上不再给出相反结论', () => {
    assert.equal(
      p1().crossPathDisagreement,
      0,
      '仍有题目「检索说没有、注入说存在」——两条路径的隔离规则又分叉了'
    );
  });

  test('带 sessionId 的注入路径召回不低于无 sessionId 的兼容路径', () => {
    const recall = p1().recallAtK;

    // P0 之前线上注入走的是无隔离路径：它「召回高」正是靠泄漏别的会话换来的。
    // 修好后带上 sessionId 的那条应当至少不差于不带的那条。
    assert.ok(
      recall.injectScoped[10] >= recall.inject[10],
      `injectScoped@10=${recall.injectScoped[10]} 低于 inject@10=${recall.inject[10]}`
    );
  });

  test('无归属旧数据仍按设计对新会话可见（暴露数钉在基线值，变了要重新论证）', () => {
    assert.equal(
      p1().legacyUnattributedExposure,
      1,
      'legacy（无 sessionId 归属）记忆的回落可见性发生变化。' +
        '这是 docs/memory-audit.md 里记明的取舍：迁移前已有的无归属条目任何会话都能读到，' +
        '数值变化说明回落规则被改动，必须重新评估而不是顺手改阈值'
    );
  });
});

describe('检索质量下限：改造不得把召回或精度做退', () => {
  test('本会话应有的答案，两条会话内路径在 K=5 与 K=10 都全中', () => {
    const recall = p1().recallAtK;

    assert.equal(recall.scoped[5], 1, 'scoped Recall@5 应维持 1.0');
    assert.equal(recall.scoped[10], 1, 'scoped Recall@10 应维持 1.0');
    assert.equal(recall.injectScoped[5], 1, '线上注入 Recall@5 应维持 1.0');
    assert.equal(recall.injectScoped[10], 1, '线上注入 Recall@10 应维持 1.0');
  });

  test('Precision 不低于基线（基线：scoped@5=0.1263 / @10=0.0632）', () => {
    const precision = p1().precisionAtK;

    // 精度低是「身份类条目强制进注入」这条保证的代价，记在 docs/memory-audit.md。
    // 设下界是为了抓住「排序完全失效」这一类回归，而不是要求精度好看。
    assert.ok(precision.scoped[5] >= 0.12, `Precision@5 scoped=${precision.scoped[5]}`);
    assert.ok(precision.scoped[10] >= 0.06, `Precision@10 scoped=${precision.scoped[10]}`);
    assert.ok(
      precision.injectScoped[5] >= 0.12,
      `Precision@5 injectScoped=${precision.injectScoped[5]}`
    );
  });

  test('进程内检索延迟仍在毫秒级（基线 p95 约 2ms 量级）', () => {
    for (const pathName of ['scoped', 'inject', 'injectScoped']) {
      const stat = p1().latencyMs[pathName];

      assert.ok(stat, `${pathName} 路径没有延迟样本`);
      assert.ok(
        stat.p95 < 50,
        `${pathName} p95=${stat.p95}ms，检索里出现了非常规开销（同步 IO 或平方级扫描）`
      );
    }
  });
});

describe('P0-1 事实更正：旧事实不得继续被检索，且改前先取代再删', () => {
  test('更正残留数为 0（基线 Q20/Q21 这两类题）', () => {
    assert.equal(
      p2().correctionResidueCount,
      0,
      '更正后旧事实仍在活跃记忆集或仍可被检索命中'
    );
  });

  test('至少一条旧事实是以 status=superseded 留档的方式退场的', () => {
    assert.ok(
      p2().correctionHandledBySupersede >= 1,
      '更正退化成「直接删掉旧条目」：审计链断了，回滚与追溯都无从做起'
    );
  });

  test('旧条目在磁盘上确实还在，只是不再活跃', () => {
    const supersededRows = report.perQuestion.phase2.filter(
      item => item.oldOnDiskAsSuperseded
    );

    assert.equal(
      supersededRows.length,
      p2().correctionHandledBySupersede,
      '留档计数与实际落盘的 superseded 条目数不一致'
    );

    for (const row of supersededRows) {
      assert.equal(
        row.oldAlsoVisibleToInject,
        false,
        `${row.id} 的旧事实仍被无 sessionId 注入路径看到`
      );
      assert.equal(
        row.oldAlsoVisibleToInjectScoped,
        false,
        `${row.id} 的旧事实仍被本会话注入路径看到`
      );
    }
  });
});

describe('P2-2 拒写成因可观测：每条被拒的候选都要带稳定短码', () => {
  test('没有任何一次拒写不带短码', () => {
    assert.equal(
      p2().rejectedWithoutReason,
      0,
      `这些拒写没带回短码：${JSON.stringify(p2().rejectedWithoutReasonKeys)}；` +
        `全部拒写 ${p2().rejectedAttempts} 次`
    );
    assert.equal(
      p2().rejectedWithReason,
      p2().rejectedAttempts,
      '有拒写既没算进有短码也没算进无短码，统计口径漏了'
    );
  });

  test('三类成因能被区分：模型没提取 / 被锚点拒 / 被置信度拒', () => {
    const reasons = p2().gateProbeReasons;

    for (const code of [
      'not_triggered',
      'model_empty',
      'ungrounded_content',
      'low_confidence',
    ]) {
      assert.ok(
        reasons.some(item => item.endsWith(`=${code}`)),
        `探针里没有一条产出短码 ${code}，三种成因又混成一件事了：${JSON.stringify(reasons)}`
      );
    }
  });

  test('每个鉴别探针的写入结果与短码都符合预期', () => {
    assert.deepEqual(
      p2().gateProbeMismatches,
      [],
      '闸门行为变了：探针只改一道闸门，判据不符说明该闸门不再可预测'
    );
  });

  test('锚点闸门给出可比对的数值细节，而不是只给一个「被拒」', () => {
    const anchorProbe = report.gateProbes.find(
      item => item.key === 'anchorGateProbe'
    );

    assert.ok(anchorProbe, '锚点探针不见了');
    assert.equal(anchorProbe.reason, 'ungrounded_content');
    assert.equal(
      typeof anchorProbe.anchorScore,
      'number',
      '被锚点拒时必须回传锚点分，调用方才分得清「差一点过线」和「差得远」'
    );
    assert.equal(
      typeof anchorProbe.keywordHits,
      'number',
      '被锚点拒时必须回传关键词接地命中数'
    );
  });
});

describe('P1-2/P1-3 删除与按会话清理：五个面都不许留 residue', () => {
  test('删除残留数为 0', () => {
    assert.equal(
      p3().deletionResidueCount,
      0,
      '应删的记忆仍存在于内存数组 / 磁盘 / scoped 检索 / 无归属注入 / 带会话注入之中'
    );
  });

  test('安全探针、磁盘一致性、撤回静默归零都为空', () => {
    assert.deepEqual(p3().safetyProbeFailures, []);
    assert.deepEqual(p3().memoryDiskInconsistencies, []);
    assert.deepEqual(
      p3().recallSilentlyReturnedZero,
      [],
      '有撤回请求返回 0 条但库里明明有：撤回被静默吞掉了'
    );
  });

  test('按会话清理只摘走本会话的贡献，别人的一条不少', () => {
    const cleanup = p3().sessionCleanup;

    assert.deepEqual(
      cleanup.contributionsStillOwnedByTarget,
      [],
      '清理后库里仍残留目标会话的贡献'
    );
    assert.deepEqual(
      cleanup.foreignMissing,
      [],
      '清理把其他会话独有的条目一起删了'
    );
    assert.equal(cleanup.diskConsistent, true, '清理后内存与磁盘不一致');
    assert.equal(
      cleanup.otherSessionStillSearchable,
      true,
      '其他会话的记忆被清理波及，检索不到了'
    );
  });
});

describe('P2-1 Context Engine：打开引擎后记忆要真能进上下文', () => {
  test('引擎路径不再 0 注入', () => {
    const engine = p4().engine;

    assert.equal(engine.ok, true, `引擎报错：${engine.error}`);

    const memoryItem = (engine.retrievedItems || []).find(
      item => item.source === 'memory'
    );

    assert.ok(memoryItem, '引擎的检索清单里没有 memory 来源，记忆没被纳入上下文');
    assert.ok(
      memoryItem.count >= 1,
      '引擎看到了记忆却没有产出可用条目（旧行为：打开引擎反而 0 注入）'
    );
    assert.ok(
      engine.selected >= 1,
      `引擎最终只选了 ${engine.selected} 条：同组近似候选又被整组判平局丢弃了`
    );
    assert.ok(
      engine.injectedLines.length >= 1,
      'selected 大于 0 但注入正文为空，决胜之后仍然没进上下文'
    );
  });

  test('时效字段真实存在，未知新鲜度标记为 0', () => {
    assert.equal(
      p4().engine.unknownFreshnessMarks,
      0,
      '有条目既没有 fetchedAt/validFrom 也没有回退标记，组内决胜只能猜'
    );
    assert.equal(p4().engine.expired, 0, '固定题库里没有该过期的条目');
  });

  test('同组决胜只留一个赢家（注入条数可以少于直连条数，这是设计）', () => {
    assert.ok(
      p4().engine.selected <= p4().scopedDirect.count,
      '注入条数超过直连可见条数，说明引擎凭空造了候选'
    );
  });
});
