/* global require, process, __dirname */
/**
 * 台账行级重算脚本（scripts/scan-notion-ledger.js）的口径守卫。
 *
 * 这个脚本产出的数字会直接写进台账汇总块，历史上正是汇总与行状态不一致
 * 出过多次勘误，所以解析规则必须是确定性纯函数并有单测：
 *  - 改判形态取最后一个箭头之后、左括号之前的值（括号里的日期与「判 1」不是状态）；
 *  - 解析不出来一律抛错，绝不回落成 0、绝不跳过该行；
 *  - 汇总对账只看最后一条「新值」，历史勘误行保留不参与对账。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'scan-notion-ledger.js');
const scan = require('../scripts/scan-notion-ledger');

function fixtureRows(statusOf) {
  return scan.EXPECTED_IDS.map(id => `| ${id} | 原文 | 待确认 | 依据 | ${statusOf(id)} | 证据 | 下一步 |`).join('\n');
}

function fixtureDoc(statusOf, summaryLine) {
  return [
    '# 台账',
    '',
    '## 表 2 · 25 项验收归属台账（25 行）',
    '',
    '| 编号 | 原文 | 归属 | 依据 | 状态 | 证据 | 下一步 |',
    '|---|---|---|---|---|---|---|',
    fixtureRows(statusOf),
    '',
    '**汇总（勘误）**：',
    '- 新值（第一次）：`1` = 1 项（A-01）；`0.5` = 0 项（）；`0` = 0 项（）。合计 1+0+0=1。',
    summaryLine,
    '',
    '## 下一节',
  ].join('\n');
}

function summaryLine(counts, lists) {
  return `- 新值（最新）：\`1\` = ${counts[1]} 项（${lists[1].join('、')}）；\`0.5\` = ${counts[0.5]} 项（${lists[0.5].join('、')}）；\`0\` = ${counts[0]} 项（${lists[0].join('、')}）。合计 ${counts[1]}+${counts[0.5]}+${counts[0]}=${counts[1] + counts[0.5] + counts[0]}。`;
}

test('a. 状态列：四种平铺取值与两个方向的改判形态', () => {
  assert.equal(scan.parseStatusCell('1').value, 1);
  assert.equal(scan.parseStatusCell('1.0').value, 1, '1.0 与 1 是同一个判定');
  assert.equal(scan.parseStatusCell('0.5').value, 0.5);
  assert.equal(scan.parseStatusCell('0').value, 0);
  assert.equal(scan.parseStatusCell('1').previous, null);

  const up = scan.parseStatusCell('0 → 0.5（勘误 2026-11-07：机制已落地）');
  assert.equal(up.value, 0.5);
  assert.equal(up.previous, 0);
  const down = scan.parseStatusCell('1.0 → 0.5（勘误 2026-11-06：判 1 与行内缺口自相矛盾）');
  assert.equal(down.value, 0.5, '括号里的「判 1」不是状态');
  assert.equal(down.previous, 1);
  assert.equal(scan.parseStatusCell(' 0.5 → 1.0（旧值保留，勘误 2026-11-05） ').value, 1);
});

test('b. 状态列解析不出来一律抛错，不回落成 0', () => {
  for (const bad of ['', '   ', '已完成', '0.7', '2', '1.0 → 待定', '待定 → 1.0', '未勾选']) {
    assert.throws(() => scan.parseStatusCell(bad), /无法识别的状态取值|状态列为空/, `「${bad}」必须抛错`);
  }
});

test('c. 行级重算：25 行按编号归位，计数与名单都由行状态推出', () => {
  const doc = fixtureDoc(id => (id === 'A-07' || id === 'B-07' ? '0' : id.endsWith('1') ? '0.5' : '1.0'));
  const result = scan.scanRows(doc);
  assert.equal(result.total, 25);
  assert.deepEqual(result.rows.map(row => row.id), scan.EXPECTED_IDS, '行序按登记编号，不按文件里的偶然顺序');
  assert.deepEqual(result.lists[0], ['A-07', 'B-07']);
  assert.equal(result.counts[0], 2);
  assert.equal(result.counts[1] + result.counts[0.5] + result.counts[0], 25);
});

test('d. 行级重算 fail-closed：缺行、重号、未登记编号、列数不足、缺小节都抛错', () => {
  const ok = fixtureDoc(() => '1');
  assert.throws(() => scan.scanRows(ok.replace('| A-07 | 原文 | 待确认 | 依据 | 1 | 证据 | 下一步 |\n', '')), /缺少行：A-07/);
  assert.throws(() => scan.scanRows(ok.replace('| B-11 |', '| A-01 |')), /编号重复：A-01/);
  assert.throws(() => scan.scanRows(ok.replace('| B-11 |', '| C-01 |')), /缺少行：B-11/);
  assert.throws(() => scan.scanRows(ok.replace('| A-07 | 原文 | 待确认 | 依据 | 1 | 证据 | 下一步 |', '| A-07 | 原文 | 待确认 |')), /列数不足/);
  assert.throws(() => scan.scanRows(ok.replace('## 表 2', '## 表二')), /找不到小节/);
  assert.throws(() => scan.scanRows(ok.replace('**汇总', '**总计')), /结束标记/);
});

test('e. 汇总解析：只取最后一条「新值」，历史勘误行不参与对账', () => {
  const lists = { 1: scan.EXPECTED_IDS, 0.5: [], 0: [] };
  const doc = fixtureDoc(() => '1', summaryLine({ 1: 25, 0.5: 0, 0: 0 }, lists));
  const summary = scan.parseSummary(doc);
  assert.match(summary.label, /最新/);
  assert.deepEqual(summary.counts, { 1: 25, 0.5: 0, 0: 0 });
  assert.deepEqual(summary.statedTotal, { parts: [25, 0, 0], sum: 25 });

  const emptyBuckets = scan.parseSummary(fixtureDoc(() => '1', `- 新值（空档写无）：\`1\` = 25 项（${scan.EXPECTED_IDS.join('、')}）；\`0.5\` = 0 项（无）；\`0\` = 0 项（无）。合计 25+0+0=25。`));
  assert.deepEqual(emptyBuckets.lists[0.5], [], '「无」是空档标记，不是一个编号');
  assert.deepEqual(emptyBuckets.lists[0], []);
  assert.equal(emptyBuckets.counts[0], 0);
  assert.throws(() => scan.parseSummary('## 表 2\n\n**汇总（勘误）**：\n- 旧值（上一轮）：随便写\n'), /没有「- 新值」行/);
  assert.throws(() => scan.parseSummary(' nothing '), /找不到汇总块/);
});

test('f. 对账：计数、名单、汇总自相矛盾与合计算式四类不一致都要报出来', () => {
  const statusOf = id => (id === 'A-07' ? '0' : '1');
  const truth = { 1: scan.EXPECTED_IDS.filter(id => id !== 'A-07'), 0.5: [], 0: ['A-07'] };
  const doc = fixtureDoc(statusOf, summaryLine({ 1: 24, 0.5: 0, 0: 1 }, truth));
  const result = scan.scanRows(doc);
  assert.deepEqual(scan.compare(result, scan.parseSummary(doc)), { consistent: true, mismatches: [] });

  const wrongCount = scan.compare(result, scan.parseSummary(fixtureDoc(statusOf, summaryLine({ 1: 23, 0.5: 0, 0: 1 }, truth))));
  assert.equal(wrongCount.consistent, false);
  assert.match(wrongCount.mismatches.join('\n'), /计数不一致（1）：行级 24，汇总 23/);

  // 计数相同但编号换了一个：只看总数会漏掉这种错。
  const swapped = { ...truth, 1: [...truth[1].slice(1), 'A-07'], 0: ['A-07'] };
  const wrongList = scan.compare(result, scan.parseSummary(fixtureDoc(statusOf, summaryLine({ 1: 24, 0.5: 0, 0: 1 }, swapped))));
  assert.equal(wrongList.consistent, false);
  assert.match(wrongList.mismatches.join('\n'), /名单不一致（1）/);

  const selfContradict = scan.compare(result, scan.parseSummary(fixtureDoc(statusOf, summaryLine({ 1: 24, 0.5: 0, 0: 1 }, { ...truth, 1: truth[1].slice(1) }))));
  assert.equal(selfContradict.consistent, false);
  assert.match(selfContradict.mismatches.join('\n'), /汇总自相矛盾（1）：写 24 项但列了 23 个编号/);

  const badTotal = scan.parseSummary(fixtureDoc(statusOf, summaryLine({ 1: 24, 0.5: 0, 0: 1 }, truth).replace('合计 24+0+1=25', '合计 24+0+1=26')));
  const totalMismatch = scan.compare(result, badTotal);
  assert.equal(totalMismatch.consistent, false);
  assert.match(totalMismatch.mismatches.join('\n'), /合计算式不成立/);
});

test('g. 真实台账：25 行齐备，行状态与最新汇总一致（CI 每次都跑这条）', () => {
  const text = fs.readFileSync(scan.LEDGER_FILE, 'utf8');
  const result = scan.scanRows(text);
  assert.equal(result.total, 25);
  assert.equal(result.counts[1] + result.counts[0.5] + result.counts[0], 25);
  const verdict = scan.compare(result, scan.parseSummary(text));
  assert.deepEqual(verdict.mismatches, [], '台账行状态与汇总块必须一致');
  assert.equal(verdict.consistent, true);
});

test('h. CLI：--check 对账、--json 可解析、参数写错与被改坏的台账都非零退出', () => {
  const run = args => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 });

  const checked = run(['--check']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /行状态与汇总一致/);

  const jsoned = run(['--json']);
  assert.equal(jsoned.status, 0, jsoned.stderr);
  const view = JSON.parse(jsoned.stdout);
  assert.equal(view.rows.length, 25);
  assert.equal(view.consistent, true);

  assert.equal(run(['--typo']).status, 1);
  assert.match(run(['--typo']).stderr, /未知参数：--typo/);
  assert.equal(run(['--file']).status, 1);
  assert.match(run(['--file']).stderr, /--file 缺少取值/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-scan-'));
  try {
    const tampered = path.join(dir, 'tampered.md');
    const text = fs.readFileSync(scan.LEDGER_FILE, 'utf8');
    const latest = scan.parseSummary(text).line;
    // 只改汇总里的一个计数，行状态不动：这正是历史上出过的错。
    fs.writeFileSync(tampered, text.replace(latest, latest.replace(/`1` = \d+/, '`1` = 99')), 'utf8');
    const bad = run(['--check', '--file', tampered]);
    assert.equal(bad.status, 1, '汇总被改坏必须非零退出');
    assert.match(bad.stdout, /计数不一致（1）/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});