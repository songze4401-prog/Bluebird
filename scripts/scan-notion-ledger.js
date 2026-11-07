#!/usr/bin/env node
/* global require, module, process, __dirname */
/**
 * 台账行级重算：把 docs/notion-delivery-ledger-2026-11-04.md 表 2 的 25 行状态
 * 逐行切出来重算汇总，并与汇总块最后一条「新值」对账。
 *
 * 为什么要有这个脚本：台账历史上出现过多次「行状态与汇总数字不一致」
 * （初版把 A-09 计为 0 而行内写 0.5；第四次回填的汇总与行级改判不同步）。
 * 口径固定为：切第 5 列（状态列），取最后一次改判的值，不按记忆写数字。
 * 解析不出来一律抛错（fail-closed），绝不回落成 0 或跳过该行。
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LEDGER_FILE = path.join(REPO_ROOT, 'docs', 'notion-delivery-ledger-2026-11-04.md');

const EXPECTED_IDS = Object.freeze([
  ...Array.from({ length: 14 }, (_, i) => `A-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 11 }, (_, i) => `B-${String(i + 1).padStart(2, '0')}`),
]);

const VALUES = Object.freeze([1, 0.5, 0]);
const STATUS_COLUMN = 5;

function normalizeVerdict(token, context) {
  const text = String(token).trim();
  if (text === '1' || text === '1.0') return 1;
  if (text === '0.5') return 0.5;
  if (text === '0' || text === '0.0') return 0;
  throw new Error(`无法识别的状态取值「${text}」（${context}）；只接受 1 / 1.0 / 0.5 / 0`);
}

/**
 * 状态列有两种形态：`0.5` 与 `0 → 0.5（勘误 …）`。
 * 改判形态取最后一个箭头之后、左括号之前的那一段——括号里是勘误理由，
 * 含日期与「判 1 与行内缺口自相矛盾」这类数字，绝不能拿它当状态。
 */
function parseStatusCell(cell, context = '状态列') {
  const raw = String(cell).trim();
  if (!raw) throw new Error(`状态列为空（${context}）`);
  const segments = raw.split('→');
  const last = segments[segments.length - 1];
  const head = last.split('（')[0].split('(')[0].trim();
  const value = normalizeVerdict(head, context);
  const previous = segments.length > 1 ? normalizeVerdict(segments[0].split('（')[0], `${context} 的旧值`) : null;
  return { value, previous, raw };
}

function tableSection(text, { heading = '## 表 2', stop = '**汇总' } = {}) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(heading));
  if (start < 0) throw new Error(`找不到小节「${heading}」`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith(stop));
  if (end < 0) throw new Error(`找不到「${heading}」的结束标记「${stop}」`);
  return lines.slice(start, end);
}

function scanRows(text) {
  const rows = [];
  for (const line of tableSection(text)) {
    if (!/^\|\s*[AB]-\d\d\s*\|/.test(line)) continue;
    const columns = line.split('|').map(item => item.trim());
    const id = columns[1];
    if (columns.length <= STATUS_COLUMN) throw new Error(`${id} 行列数不足（${columns.length}），切不到第 5 列状态`);
    const status = parseStatusCell(columns[STATUS_COLUMN], id);
    rows.push({ id, ...status, line: line.trim() });
  }

  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`编号重复：${row.id}`);
    seen.set(row.id, row);
  }
  const missing = EXPECTED_IDS.filter(id => !seen.has(id));
  if (missing.length) throw new Error(`缺少行：${missing.join('、')}`);
  const extra = rows.map(row => row.id).filter(id => !EXPECTED_IDS.includes(id));
  if (extra.length) throw new Error(`出现未登记的编号：${extra.join('、')}`);

  const lists = { 1: [], 0.5: [], 0: [] };
  for (const id of EXPECTED_IDS) lists[seen.get(id).value].push(id);
  const counts = { 1: lists[1].length, 0.5: lists[0.5].length, 0: lists[0].length };
  return { rows: EXPECTED_IDS.map(id => seen.get(id)), lists, counts, total: rows.length };
}

const SUMMARY_PATTERN = /`1`\s*=\s*(\d+)\s*项（([^）]*)）；`0\.5`\s*=\s*(\d+)\s*项（([^）]*)）；`0`\s*=\s*(\d+)\s*项（([^）]*)）/g;
const TOTAL_PATTERN = /合计\s*(\d+)\+(\d+)\+(\d+)=(\d+)/;

function idList(text) {
  return String(text)
    .split('、')
    .map(item => item.trim())
    // 空档在台账里写成「（无）」；'无' 不是编号，不能当成一个成员参与对账。
    .filter(item => item && item !== '无');
}

/** 汇总块保留全部历史勘误行，对账只看最后一条「新值」。 */
function parseSummary(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('**汇总'));
  if (start < 0) throw new Error('找不到汇总块（**汇总）');
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const block = lines.slice(start, end < 0 ? lines.length : end).join('\n');
  const bullets = block.split(/\r?\n/).filter(line => line.startsWith('- 新值'));
  if (!bullets.length) throw new Error('汇总块里没有「- 新值」行');
  const latest = bullets[bullets.length - 1];
  const matches = [...latest.matchAll(SUMMARY_PATTERN)];
  if (matches.length !== 1) throw new Error(`最新汇总行解析出 ${matches.length} 组计数，应为 1 组：${latest}`);
  const [, c1, l1, cHalf, lHalf, c0, l0] = matches[0];
  const counts = { 1: Number(c1), 0.5: Number(cHalf), 0: Number(c0) };
  const lists = { 1: idList(l1), 0.5: idList(lHalf), 0: idList(l0) };
  const totalMatch = latest.match(TOTAL_PATTERN);
  const statedTotal = totalMatch
    ? { parts: [Number(totalMatch[1]), Number(totalMatch[2]), Number(totalMatch[3])], sum: Number(totalMatch[4]) }
    : null;
  return { label: latest.replace(/^- /, '').split('：')[0], counts, lists, statedTotal, line: latest };
}

function sameMembers(a, b) {
  const key = list => [...list].sort().join('|');
  return key(a) === key(b);
}

function compare(scan, summary) {
  const mismatches = [];
  for (const value of VALUES) {
    const key = String(value);
    if (scan.counts[value] !== summary.counts[value]) {
      mismatches.push(`计数不一致（${key}）：行级 ${scan.counts[value]}，汇总 ${summary.counts[value]}`);
    }
    if (!sameMembers(scan.lists[value], summary.lists[value])) {
      const onlyRows = scan.lists[value].filter(id => !summary.lists[value].includes(id));
      const onlySummary = summary.lists[value].filter(id => !scan.lists[value].includes(id));
      mismatches.push(
        `名单不一致（${key}）：只在行级 [${onlyRows.join('、') || '无'}]，只在汇总 [${onlySummary.join('、') || '无'}]`
      );
    }
    if (summary.lists[value].length !== summary.counts[value]) {
      mismatches.push(`汇总自相矛盾（${key}）：写 ${summary.counts[value]} 项但列了 ${summary.lists[value].length} 个编号`);
    }
  }
  if (summary.statedTotal) {
    const { parts, sum } = summary.statedTotal;
    const expected = [summary.counts[1], summary.counts[0.5], summary.counts[0]];
    if (!sameMembers(parts, expected) || parts.reduce((a, b) => a + b, 0) !== sum) {
      mismatches.push(`合计算式不成立：${parts.join('+')}=${sum}，按计数应为 ${expected.join('+')}=${expected.reduce((a, b) => a + b, 0)}`);
    }
  }
  if (scan.total !== EXPECTED_IDS.length) mismatches.push(`行数 ${scan.total}，应为 ${EXPECTED_IDS.length}`);
  return { consistent: mismatches.length === 0, mismatches };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { check: false, json: false, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--check') args.check = true;
    else if (token === '--json') args.json = true;
    else if (token === '--file') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--file 缺少取值');
      args.file = value;
      i += 1;
    } else if (token.startsWith('--file=')) {
      args.file = token.slice('--file='.length);
      if (!args.file) throw new Error('--file 缺少取值');
    } else throw new Error(`未知参数：${token}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const file = args.file ? path.resolve(args.file) : LEDGER_FILE;
  const text = fs.readFileSync(file, 'utf8');
  const scan = scanRows(text);
  const summary = parseSummary(text);
  const verdict = compare(scan, summary);

  if (args.json) {
    console.log(JSON.stringify({ file, counts: scan.counts, lists: scan.lists, rows: scan.rows.map(({ id, value, previous }) => ({ id, value, previous })), summary: { label: summary.label, counts: summary.counts }, ...verdict }, null, 2));
  } else {
    console.log(`台账行级重算：${path.relative(REPO_ROOT, file)}`);
    for (const value of VALUES) console.log(`  ${value} = ${scan.counts[value]} 项（${scan.lists[value].join('、') || '无'}）`);
    console.log(`  合计 ${scan.total} 行；最新汇总：${summary.label}`);
    console.log(verdict.consistent ? '✔ 行状态与汇总一致' : `✘ 行状态与汇总不一致：\n  - ${verdict.mismatches.join('\n  - ')}`);
  }
  if (args.check && !verdict.consistent) return 1;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[ledger-scan] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED_IDS, VALUES, LEDGER_FILE, normalizeVerdict, parseStatusCell, scanRows, parseSummary, compare, parseArgs, main };