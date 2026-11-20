/**
 * docs/ 目录布局守卫（2026-11-21 收尾条 6）。
 *
 * 规则见 docs/README.md：顶层只放现行文档，带日期的一次性记录进 docs/archive/。
 * 活台账 notion-delivery-ledger-2026-11-04.md 是唯一例外（脚本与 CI 直接读它）。
 *
 * 运行：node tests/doc-layout.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const KEEP_DATED = new Set(['notion-delivery-ledger-2026-11-04.md']);
const DATED = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;

test('docs 顶层不再混入带日期的历史文档（活台账除外）', () => {
  const offenders = fs
    .readdirSync(DOCS)
    .filter(name => name.endsWith('.md') && DATED.test(name) && !KEEP_DATED.has(name));

  assert.deepEqual(
    offenders,
    [],
    `这些带日期的文档还在 docs 顶层：${offenders.join(', ')}——按 docs/README.md 归档到 docs/archive/`
  );
});

test('docs 顶层保留现行文档与目录说明', () => {
  const names = fs.readdirSync(DOCS);

  for (const required of ['README.md', 'agent-policy.md', 'architecture-map.md', 'unified-retrieval.md']) {
    assert.ok(names.includes(required), `docs/${required} 不在顶层：现行文档被误归档了`);
  }

  assert.ok(
    names.includes('notion-delivery-ledger-2026-11-04.md'),
    '活台账被归档了：scripts/scan-notion-ledger.js 与 CI 会读不到'
  );
  assert.ok(fs.existsSync(path.join(DOCS, 'archive')), 'docs/archive/ 不存在，历史快照没地方放');
});

test('docs/README.md 讲清了现行与历史的判定规则', () => {
  const text = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf8');

  assert.match(text, /现行/, 'README 没写现行文档口径');
  assert.match(text, /archive/, 'README 没写归档目录');
  assert.match(text, /notion-delivery-ledger-2026-11-04\.md/, 'README 没写活台账例外');
});
